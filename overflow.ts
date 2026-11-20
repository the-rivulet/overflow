// this just bugs me
Symbol.prototype.toString = function() { return this.description!; };

// anything that can be evaluated to get a value
type Expression = symbol | IExpr;
interface IExpr {
    checkExprType(symTable: SymTable): Type;
    evalExpr(symTable: SymTable): Value;
}
// anything that can be evaluated to do something
type Statement = IStmt;
interface IStmt {
    checkStmtType(symTable: SymTable): SymTable;
    evalStmt(symTable: SymTable): SymTable;
}
// anything that can be used as a type
// `symbol` appears again, because a symbol could point to a class
type Type = symbol | IType;
interface IType {
    isSameType(b: Type, symTable: SymTable): boolean;
}

abstract class Thing implements IExpr {
    private readonly _thing!: void;
    abstract isSameThing(b: Thing, symTable: SymTable): boolean;
    abstract checkExprType(symTable: SymTable): Type;
    evalExpr(symTable: SymTable): Value {
        return new Value(this, checkExprType(this, symTable));
    }
    asType(): IType {
        if(!("isSameType" in this)) throw new Error(`${this.toString()} isn't even remotely like a Type`);
        return this as unknown as IType;
    }
}

// opaque values, used for passing in external arguments
class OpaqueThing extends Thing {
    constructor(public data: any) { super(); }
    toString() {return `opaque "${this.data?.toString()}"`;}
    isSameThing(b: Thing, _: SymTable): boolean { return b instanceof OpaqueThing && this.data == b.data; }
    checkExprType(_: SymTable): Type { return Symbol(); /* basically useless since it's Opaque */ }
}
// a name with its type
class Identifier {
    constructor(public name: symbol, public kind: Type) {}
    toString() {return `${this.name.description} : ${this.kind.toString()}`;}
}
// a value with its type
class Value {
    constructor(public data: Thing, public kind: Type) {}
    toString() {
        // if this is a `Func`, its type might be hidden in its closure table, making it harder to understand
        // so, if it is, try to evaluate it
        if(this.data instanceof Func && this.kind instanceof FuncType) {
            const ctable = this.data.closureTable, i = this.kind.inType, o = this.kind.outType;
            const i2 = (typeof i == "symbol" && i in ctable) ? ctable[i]!.data.asType() : i;
            const o2 = (typeof o == "symbol" && o in ctable) ? ctable[o]!.data.asType() : o;
            return `${this.data.toString()} : ${new FuncType(i2, o2).toString()}`
        }
        return `${this.data} : ${this.kind.toString()}`;
    }
}

// calling a function on arguments
class Call implements IExpr {
    constructor(public func: Expression, public argument: Expression) {}
    toString(): string {return `${this.func.toString()}(${this.argument.toString()})`;}
    checkExprType(symTable: SymTable): Type {
        // first check the type of the thing we're calling...
        const vt = checkExprType(this.func, symTable);
        // ... and that it is a function
        if(!(vt instanceof FuncType)) {
            throw new Error(`${this.func.toString()} is not a function type, it is: ${vt.toString()}`);
        }
        // now check the type of the argument...
        const at = checkExprType(this.argument, symTable);
        // ... and ensure the argument's type is correct
        if(!(accepts(at, vt.inType, symTable))) {
            throw new Error(`Cannot call function ${this.func.toString()} of type ${vt.toString()} with argument ${this.argument.toString()} of type ${at.toString()}`);
        }
        // just give the return type
        return vt.outType;
    }
    evalExpr(symTable: SymTable): Value {
        // first make sure that the thing we're calling is defined...
        const v = evalExpr(this.func, symTable);
        // ... and that it is a function
        if(!(v.data instanceof Func)) {
            throw new Error(`${this.func.toString()} is not a function, it is: ${v.toString()}`);
        }
        const f: Func = v.data;
        // use the closure table
        const fullTable = {...symTable, ...f.closureTable};
        // now evaluate the argument...
        const a = evalExpr(this.argument, fullTable);
        // ... and ensure the argument's type is correct
        if(!(accepts(a.kind, f.argument.kind, fullTable))) {
            console.warn(f.argument.kind.toString());
            // when throwing an error in this way, try to use the closure table to change the argument type
            // into a more specific one. (it is not useful to see "expected T, got..." when you don't know what T is)
            const extraInfo = (typeof f.argument.kind == "symbol" && f.argument.kind in f.closureTable) ? ` (${f.closureTable[f.argument.kind]?.data?.toString()})` : "";
            
            throw new Error(`Expected an argument of type ${f.argument.kind.toString()}${extraInfo} for ${f.toString()}, but got ${a.toString()}`);
        }
        // make a copy of the symbol table to add the argument to it
        // a copy is made because the argument symbols should not be retained after the function call
        // also add the closure table if the function has one
        const innerSymTable: SymTable = {...symTable, ...f.closureTable, [f.argument.name]: a};
        // after filling out the arguments in `innerSymTable`, evaluate it
        return evalExpr(f.definition, innerSymTable);
    }
}
// defining a variable, allowing its identifier to be meaningful when evaluated later
// this cannot be used to define functions, use `FuncDefinition` instead.
// this is not an expression, instead it is a statement.
class VarDefinition implements IStmt {
    constructor(public name: symbol, public value: Expression) {}
    toString() {return `${this.name.description} = ${this.value.toString()}`;}
    checkStmtType(symTable: SymTable): SymTable {
        return {...symTable, [this.name]: new Value(new OpaqueThing(undefined), checkExprType(this.value, symTable))};
    }
    evalStmt(symTable: SymTable): SymTable {
        // define the variable and add it to the symbol table
        // throw an error if you try to reinstantiate an existing symbol
        // cause it's better for things to be const by default
        // especially important now that closures exist (because they would use the old value)
        if(this.name in symTable) {
            throw new Error(`${this.name.description} is already defined`);
        }
        return {...symTable, [this.name]: evalExpr(this.value, symTable)};
    }
}
// returns a value from a statement, allowing it to be used as an expression.
// this is the only way to have a statement return a value.
class Return implements IExpr {
    constructor(public stmts: Statement[], public returns: Expression) {}
    toString(): string {return `${this.stmts.map(x => x.toString()).join("; ")}; return ${this.returns.toString()}`;}
    checkExprType(symTable: SymTable): Type {
        // evaluate the statements in the `Return` for their types
        const symTable2 = this.stmts.reduce((table, stmt) => checkStmtType(stmt, table), {...symTable});
        return checkExprType(this.returns, symTable2);
    }
    evalExpr(symTable: SymTable): Value {
        const outTable = this.stmts.reduce((table, stmt) => evalStmt(stmt, table), symTable);
        return evalExpr(this.returns, outTable);
    }
}
// used to define functions
class FuncDefinition implements IStmt {
    constructor(public name: symbol, public argument: Identifier, public definition: Expression) {}
    toString() {return `fn ${this.name.description}(${this.argument.toString()}) { ${this.definition.toString()} }`;}
    checkStmtType(symTable: SymTable): SymTable {
        const symTable2 = {...symTable, [this.argument.name]: new Value(new OpaqueThing(undefined), this.argument.kind)};
        return {...symTable, [this.name]: new Value(new OpaqueThing(undefined), new FuncType(this.argument.kind, checkExprType(this.definition, symTable2)))};
    }
    evalStmt(symTable: SymTable): SymTable {
        // the whole thing will be stored in the symbol table so it can be called when needed
        // a variable just stores a value, but a function stores a whole object
        // when checking the function's return type, it may reference the argument
        // so the argument should be temporarily added to the symbol table while type-checking
        const symTable2 = {...symTable, [this.argument.name]: new Value(new OpaqueThing(undefined), this.argument.kind)};
        const f = new Func(this.argument, this.definition);
        // the function captures the current symbol table
        f.closureTable = {...symTable};
        return {...symTable, [this.name]: new Value(f, new FuncType(this.argument.kind, checkExprType(this.definition, symTable2)))};
    }
}
// a function disconnected from its name. if a `FuncDefinition` is `const id = (x => x);`
// then the `Func` created would just be `x => x`
// when a `Func` is instantiated from a `FuncDefinition` or returned from another function, it captures its context
class Func extends Thing {
    closureTable: SymTable;
    constructor(public argument: Identifier, public definition: Expression) { super(); this.closureTable = {}; }
    toString(): string {
        // when stringifying a function, use its closure table to resolve types before printing them
        // so that a more helpful type can be given
        const argType = (typeof this.argument.kind == "symbol" && this.argument.kind in this.closureTable)
            ? this.closureTable[this.argument.kind]!.data.asType()
            : this.argument.kind;
        return `(${new Identifier(this.argument.name, argType).toString()}) => { ${this.definition.toString()} }`;
    }
    isSameThing(_b: Thing, _symTable: SymTable): boolean { return false; }
    checkExprType(symTable: SymTable): Type {
        const symTable2 = {...symTable, [this.argument.name]: new Value(new OpaqueThing(undefined), this.argument.kind)};
        return new FuncType(this.argument.kind, checkExprType(this.definition, symTable2));
    }
    evalExpr(symTable: SymTable): Value {
        //console.info(`Adding a closure table: ${Reflect.ownKeys(symTable).map(x => x.toString()).join(", ")}`);
        this.closureTable = {...symTable};
        return super.evalExpr(symTable);
    }
}
class FuncType implements IType {
    constructor(public inType: Type, public outType: Type) {}
    toString(): string {return `(${this.inType.toString()} => ${this.outType.toString()})`;}
    isSameType(b: Type, symTable: SymTable): boolean {
        return b instanceof FuncType && isSameType(this.inType, b.inType, symTable) && isSameType(this.outType, b.outType, symTable);
    }
}
// match-expressions, the fundamental control flow pattern
class MatchCase {
    constructor(public lhs: Expression, public rhs: Expression) {}
    toString(): string {return `${this.lhs.toString()} -> ${this.rhs.toString()}`}
}
class Match implements IExpr {
    constructor(public variable: Expression, public cases: MatchCase[], public otherwise: Expression) {}
    toString(): string {return `match(${this.variable.toString()}) { ${[...this.cases, `else -> ${this.otherwise.toString()}`].map(x => x.toString()).join("; ")} }`;}
    checkExprType(symTable: SymTable): Type {
        if(this.cases.length == 0) throw new Error("Match has no arms");
        // the type should be the type of all match arms
        const arm1 = checkExprType(this.cases[0]!.rhs, symTable);
        for(const arm of this.cases.slice(1)) {
            const at = checkExprType(arm.rhs, symTable);
            if(!(accepts(at, arm1, symTable))) throw new Error(`First match arm returns type ${arm1.toString()}, but another arm returns type ${at.toString()}`);
        }
        // check the default case too
        const defaultCase = checkExprType(this.otherwise, symTable);
        if(!(accepts(defaultCase, arm1, symTable))) throw new Error(`First match arm returns type ${arm1.toString()}, but default case returns type ${defaultCase.toString()}`);
        return arm1;
    }
    evalExpr(symTable: SymTable): Value {
        const v = evalExpr(this.variable, symTable);
        // call the appropriate expression
        for(const c of this.cases) {
            const lhs = evalExpr(c.lhs, symTable);
            if(isSameValue(v, lhs, symTable)) return evalExpr(c.rhs, symTable);
        }
        return evalExpr(this.otherwise, symTable);
    }
}

// objects are a very useful type, because they allow "more types" to be created.
// objects hold a collection of named and typed values
// `ObjClass` is like `Func` ... in that it is a `Thing`.
// the type of every `ObjClass` is a special type: `Symbol.for("Type")`
class ObjClass extends Thing implements IType {
    // oh no not more closure tables...
    // yeah it turns out that factory functions (... => Type) might need them
    // at least it should be less painful to implement the second time around
    closureTable: SymTable;
    // each item in `constructors` is one way to construct this object
    constructor(public constructors: Record<symbol, Identifier[]>, private debugName: string = "", private debugFields: Expression[] = []) { super(); this.closureTable = {}; }
    toString() {
        const ctable = this.closureTable;
        const reFields: Record<symbol, Identifier[]> = {};
        for(const key of Reflect.ownKeys(this.constructors)) {
            const ids = this.constructors[key as symbol]!;
            reFields[key as symbol] = ids.map(id => new Identifier(
                id.name,
                (typeof id.kind == "symbol" && id.kind in ctable) ? ctable[id.kind]!.data.asType() : id.kind
            ));
        }
        return "class " + (this.debugName ? `${this.debugName}${this.debugFields.length ? `<${this.debugFields.map(x => evalExpr(x, this.closureTable).data.toString().replace("class ", "")).join(", ")}>` : ""}` : `{ ${Reflect.ownKeys(reFields).map(x => `${x.toString()} (${reFields[x as symbol]!.join(", ")})`).join(", ")} }`);
    }
    isSameThing(b: Thing, symTable: SymTable): boolean {
        // classes are equal if their structures are the same
        // generally `isSameThing` will be identical to `isSameType` if the latter exists
        // because that means they can be compared as things OR as types
        return b instanceof ObjClass && isSameType(this, b, symTable);
    }
    checkExprType(_: SymTable): Type {
        return new UniverseType(); // the type of any class is Type
    }
    evalExpr(symTable: SymTable) {
        this.closureTable = {...symTable};
        return new Value(this, new UniverseType());
    }
    isSameType(b: Type, symTable: SymTable): boolean {
        return b instanceof ObjClass &&
        Reflect.ownKeys(this.constructors).length == Reflect.ownKeys(b.constructors).length &&
        Reflect.ownKeys(this.constructors).every(x => Reflect.ownKeys(b.constructors).includes(x)) &&
        Reflect.ownKeys(this.constructors).every(x => this.constructors[x as symbol]!.every(
            i => b.constructors[x as symbol]!.find(j => i.name == j.name && isSameType(i.kind, j.kind, symTable))
        ));
    }
}
class NonconstructibleObjClass extends ObjClass {
    constructor(private secretKey: symbol) { super({}, secretKey.description); }
    isSameType(b: Type, _: SymTable): boolean {
        return b instanceof NonconstructibleObjClass && this.secretKey == b.secretKey;
    }
}
// special class for the Any type.
const Any = new NonconstructibleObjClass(Symbol.for("Any"));
// special class for the Type type.
class UniverseType extends NonconstructibleObjClass {
    constructor(public universeLevel: number = 0) {
        super(Symbol.for(universeLevel == 0 ? "Type" : "Type " + universeLevel));
    }
    checkExprType(_: SymTable): Type {
        return new UniverseType(this.universeLevel + 1);
    }
    evalExpr(symTable: SymTable) {
        this.closureTable = {...symTable};
        return new Value(this, new UniverseType(this.universeLevel + 1));
    }  
}
// constructs a new object
class Construct implements IExpr {
    constructor(public toaster: Expression, public cons: symbol, public fields: Record<symbol, Expression>) {}
    toString(): string {return `${this.toaster.toString()}.${this.cons.description}(${Reflect.ownKeys(this.fields).map(x => `${x.toString()} = ${this.fields[x as symbol]!.toString()}`).join(", ")})`;}
    checkExprType(symTable: SymTable): Type {
        return checkExprType(this.toaster, symTable);
    }
    evalExpr(symTable: SymTable): Value {
        // construct an object
        // the actual fields of the object will be checked in the `Thing` branch of this function
        // so no need to do the work twice
        const cons = evalExpr(this.toaster, symTable);
        if(!(cons.data instanceof ObjClass)) {
            throw new Error(`${this.toaster.toString()} is not a class, it is: ${cons.toString()}`);
        }
        // evaluate each field
        // also, take into account the object's closure table if it has one
        const fullTable = {...symTable, ...cons.data.closureTable};
        const computedFields: Record<symbol, Value> = {};
        for(const key of Reflect.ownKeys(this.fields)) {
            computedFields[key as symbol] = evalExpr(this.fields[key as symbol]!, fullTable);
        }
        return evalExpr(new Obj(cons.data, this.cons, computedFields), fullTable);
    }
}
// a constructed object
// there is no way to stop someone from constructing one of these with mismatched fields
// so in `evalExpr` we just have to make sure they're sound before they get actually used
class Obj extends Thing {
    constructor(public toaster: ObjClass, public cons: symbol, public fields: Record<symbol, Value>) { super(); }
    toString() {
        if(Reflect.ownKeys(this.fields).length == 0) return `object ${this.cons.description}`;
        else return `object ${this.cons.description} { ${Reflect.ownKeys(this.fields).map(x => `${x.toString()} (${this.fields[x as symbol]!})`).join(", ")} }`;
    }
    isSameThing(b: Thing, symTable: SymTable): boolean {
        // objects are equal if all their fields are equal
        // and they were constructed from the same constructor
        // `isSameType` on the prototypes will check if they are structurally equal
        // so all we need to do here is ensure that the fields' data is equal
        return b instanceof Obj &&
        this.cons == b.cons &&
        isSameType(this.toaster, b.toaster, symTable) &&
        Reflect.ownKeys(this.fields).every(f => isSameThing(b.fields[f as symbol]!.data, b.fields[f as symbol]!.data, symTable));
    }
    checkExprType(_: SymTable): Type {
        return this.toaster;
    }
    evalExpr(symTable: SymTable): Value {
        // if the value is an object, this is a good time to check it and make sure
        // that its properties match what is expected
        // first check the constructor
        if(!(this.cons in this.toaster.constructors)) {
            throw new Error(`${this.cons.description} is not a constructor for ${this.toaster.toString()}`);
        }
        // then check the properties
        // it should have all of the properties it claims to have
        // and should not have any properties it does not need
        const setP = this.toaster.constructors[this.cons]!;
        const setO = Reflect.ownKeys(this.fields);
        if(setP.length != setO.length) {
            throw new Error(`Wrong number of fields (provided ${setO.length}, wanted ${setP.length})`);
        }
        const missing = setP.find(key => !(setO.includes(key.name)));
        if(missing) {
            throw new Error(`Object is missing a property: ${missing.name.description}`);
        }
        // finally, make sure that the types of all properties are correct
        const wrong = setP.find(key => !(accepts(this.fields[key.name]!.kind, key.kind, symTable)));
        if(wrong) {
            // when throwing an error in this way, try to use the symbol table to change the argument type
            if(typeof wrong.kind == "symbol" && wrong.kind in symTable) {
                throw new Error(`Field is the wrong type (provided ${this.fields[wrong.name]?.toString()}, wanted ${wrong.kind.toString()} (${symTable[wrong.kind]?.data?.toString()}))`);
            } else {
                // if it didn't work, that's ok too.
                throw new Error(`Field is the wrong type (provided ${this.fields[wrong.name]?.toString()}, wanted ${wrong.kind.toString()})`);
            }
        }
        return super.evalExpr(symTable);
    }
}
// get a field of an object
class PropertyAccess implements IExpr {
    constructor(public obj: Expression, public field: symbol) {}
    toString(): string {return `${this.obj.toString()}.${this.field.description}`};
    checkExprType(symTable: SymTable): Type {
        return evalExpr(this, symTable).kind;
    }
    evalExpr(symTable: SymTable): Value {
        const obj = evalExpr(this.obj, symTable);
        if(!(obj.data instanceof Obj)) {
            throw new Error(`${this.obj.toString()} is not an object, it is: ${obj.toString()}`);
        }
        if(!(this.field in obj.data.fields)) {
            throw new Error(`That object does not have a field named ${this.field.description}`);
        }
        return obj.data.fields[this.field]!;
    }
}
// objects have a special kind of matching that works on their constructors
// in Lean this is a normal match expression but I'm making it a different thing for convenience
class Pattern implements IExpr {
    constructor(public variable: Expression, public cases: Record<symbol, Expression>) {}
    toString(): string {return `match(${this.variable.toString()}) { ${Reflect.ownKeys(this.cases).map(x => `${x.toString()} -> ${this.cases[x as symbol]!.toString()}`).join("; ")} }`;}
    checkExprType(symTable: SymTable) {
        const keys = Reflect.ownKeys(this.cases) as symbol[];
        if(keys.length == 0) throw new Error("Pattern has no cases");
        // the type should be the type of all match arms
        const arm1 = checkExprType(this.cases[keys[0]!]!, symTable);
        for(const arm of keys.slice(1)) {
            const at = checkExprType(this.cases[arm]!, symTable);
            if(!(accepts(at, arm1, symTable))) throw new Error(`First pattern returns type ${arm1.toString()}, but another arm returns type ${at.toString()}`);
        }
        return arm1;
    }
    evalExpr(symTable: SymTable) {
        // this is a familiar pattern by now
        const obj = evalExpr(this.variable, symTable);
        if(!(obj.data instanceof Obj)) {
            throw new Error(`${this.variable.toString()} is not an object, it is: ${obj.toString()}`);
        }
        // first, ensure all cases are handled
        const setP = Reflect.ownKeys(obj.data.toaster.constructors) as symbol[];
        const setO = Reflect.ownKeys(this.cases);
        if(setP.length != setO.length) {
            throw new Error(`Wrong number of cases in pattern (provided ${setO.length}, wanted ${setP.length})`);
        }
        const missing = setP.find(key => !(setO.includes(key)));
        if(missing) {
            throw new Error(`Pattern is missing a case: ${missing.description}`);
        }
        return evalExpr(this.cases[obj.data.cons]!, symTable);
    }
}
// get the toaster of an object
class Toaster implements IExpr {
    constructor(public obj: Expression) {}
    toString() {return `${this.obj.toString()}.toaster`;}
    checkExprType(symTable: SymTable) {
        const obj = evalExpr(this.obj, symTable);
        const k = obj.kind;
        if(!(k instanceof Thing)) {
            throw new Error(`Can't get the toaster of ${obj.toString()} because it's not an object`);
        }
        return checkExprType(k, symTable);
    }
    evalExpr(symTable: SymTable) {
        const obj = evalExpr(this.obj, symTable);
        const k = obj.kind;
        if(!(k instanceof Thing)) {
            throw new Error(`Can't get the toaster of ${obj.toString()} because it's not an object`);
        }
        return new Value(k, checkExprType(k, symTable));
    }
}

// propositions!!!! finally we're getting to the "proving" part of the program
const TProp = new NonconstructibleObjClass(Symbol.for("TProp"));
abstract class Proposition extends NonconstructibleObjClass implements IType {
    constructor() { super(Symbol.for("Prop")); }
    // isSameType(b: Type, symTable: SymTable): boolean;
    abstract isSameType(b: Type, symTable: SymTable): boolean;
    isSameThing(b: Thing, symTable: SymTable) {
        // once again, `isSameThing` is equal to `isSameType` if the latter exists
        return b instanceof Proposition && this.isSameType(b, symTable);
    }
    checkExprType(_: SymTable) {
        return TProp; // the type of any proposition is "Prop"
    }
}
class OpaqueProp extends Proposition {
    constructor(public data: any) { super(); }
    toString() {return `proposition "${this.data.toString()}"`;}
    isSameType(b: Type, symTable: SymTable): boolean { return b instanceof OpaqueProp && this.data == b.data; }
}

// function for quickly dereferencing a value
function deref(code: symbol, symTable: SymTable) {
    if(!(code in symTable)) {
        throw new Error(`Couldn't dereference identifier: ${code.toString()}`);
    }
    // otherwise return whatever it was
    return symTable[code]!;
}
// utility function for checking whether types match
// this results in infinite loops sometimes so as a stopgap measure I'm adding a hard limit on iter count
function isSameType(at: Type, bt: Type, symTable: SymTable, iters = 0): boolean {
    if(iters >= 10) {
        console.warn("Evaluated too deep while checking types");
        return false;
    }
    //console.info(`Comparing types of ${at.toString()} and ${bt.toString()}`);
    // deref
    if(typeof at == "symbol" && typeof bt == "symbol" && at == bt) return true;
    const a = (typeof at == "symbol") ? deref(at, symTable).data.asType() : at;
    const b = (typeof bt == "symbol") ? deref(bt, symTable).data.asType() : bt;
    // compare, dereferencing recursively if necessary
    return (a == at && b == bt) ? a.isSameType(b, symTable) : isSameType(a, b, symTable, iters + 1);
}
function accepts(arg: Type, target: Type, symTable: SymTable) {
    return isSameType(arg, target, symTable) || isSameType(target, Any, symTable) || isSameType(arg, Any, symTable); // for the future
}
// function for checking whether values match
function isSameThing(a: Thing, b: Thing, symTable: SymTable): boolean {
    return a.isSameThing(b, symTable);
}
// this is a kind of "equality", but it's really more like "exactly the same"
// it is conservative, returning false if the arguments aren't really exactly the same
function isSameValue(a: Value, b: Value, symTable: SymTable) {
    return isSameType(a.kind, b.kind, symTable) && isSameThing(a.data, b.data, symTable);
}

// the symbol table holds the value of every variable
type SymTable = Record<symbol, Value>;

// try to evaluate a statement, but only for its type
function checkStmtType(code: Statement, symTable: SymTable): SymTable {
    //console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    return code.checkStmtType(symTable);
}
// try to evaluate a statement, and return the new symbol table after evaluating
function evalStmt(code: Statement, symTable: SymTable): SymTable {
    //console.info(`Executing '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    return code.evalStmt(symTable);
}
const evalStmts = (code: Statement[], symTable: SymTable) => code.reduce((table, stmt) => evalStmt(stmt, table), symTable);
// try to evaluate an expression, and return its type
function checkExprType(code: Expression, symTable: SymTable): Type {
    //console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    if(typeof code == "symbol") {
        return deref(code, symTable).kind;
    } else {
        return code.checkExprType(symTable);
    }
}
// try to evaluate an expression, and return its value
function evalExpr(code: Expression, symTable: SymTable): Value {
    //console.info(`Evaluating '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => x.toString()).join(", ")}`);
    // do something based on what kind of expression it is
    if(typeof code == "symbol") {
        return deref(code, symTable);
    } else {
        return code.evalExpr(symTable);
    }
}

// boolean operations
const _Bool = Symbol("Bool"), _true = Symbol("true"), _false = Symbol("false");
const _x = Symbol("x"), _y = Symbol("y");
const _id = Symbol("id"), _not = Symbol("not"), _and = Symbol("and"), _or = Symbol("or");
const _const = Symbol("const"), _andMeta = Symbol("andMeta"), _andClosure = Symbol("andClosure"), _orMeta = Symbol("orMeta"), _orClosure = Symbol("orClosure");
const booleanOps = [
    new VarDefinition(_Bool, new ObjClass({
        [_false]: [],
        [_true]: []
    }, "Bool")),
    new VarDefinition(_false, new Construct(_Bool, _false, {})),
    new VarDefinition(_true, new Construct(_Bool, _true, {})),
    new FuncDefinition(_id, new Identifier(_x, _Bool), _x),
    new FuncDefinition(_const, new Identifier(_x, _Bool), new Func(new Identifier(_y, _Bool), _x)),
    new FuncDefinition(_not, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_true, _false)], _true
    )),
    new FuncDefinition(_and, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_true, _id)], new Func(new Identifier(_y, _Bool), _false)
    )),
    new FuncDefinition(_andMeta, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_true, _id)], new Call(_const, _false)
    )),
    new FuncDefinition(_andClosure, new Identifier(_x, _Bool), new Func(new Identifier(_y, _Bool), new Match(
        _x, [new MatchCase(_true, _y)], _false
    ))),
    new FuncDefinition(_or, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_false, _id)], new Func(new Identifier(_y, _Bool), _true)
    )),
    new FuncDefinition(_orMeta, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_false, _id)], new Call(_const, _true)
    )),
    new FuncDefinition(_orClosure, new Identifier(_x, _Bool), new Func(new Identifier(_y, _Bool), new Match(
        _x, [new MatchCase(_false, _y)], _true
    )))
];
const boolTable = evalStmts(booleanOps, {});
console.log(evalExpr(new Call(new Call(_orMeta, _true), _false), boolTable).toString());

// object testing
const _Nat = Symbol("Nat"), _zero = Symbol("zero"), _succ = Symbol("succ"), _prev = Symbol("prev");
const _0 = Symbol("0"), _anotherZero = Symbol("anotherZero"), _1 = Symbol("1"), _2 = Symbol("2");
const _is0 = Symbol("is0"), _anotherIs0 = Symbol("anotherIs0"), _num = Symbol("num");
const natNumbers = [
    new VarDefinition(_Nat, new ObjClass({
        [_zero]: [],
        [_succ]: [new Identifier(_prev, _Nat)]
    }, "Nat")),
    new VarDefinition(_0, new Construct(_Nat, _zero, {})),
    new VarDefinition(_anotherZero, new Construct(_Nat, _zero, {})),
    new VarDefinition(_1, new Construct(_Nat, _succ, {[_prev]: _0})),
    new VarDefinition(_2, new Construct(_Nat, _succ, {[_prev]: _1})),
    new FuncDefinition(_is0, new Identifier(_num, _Nat), new Match(_num, [
        new MatchCase(_0, _true)
    ], _false)),
    new FuncDefinition(_anotherIs0, new Identifier(_num, _Nat), new Pattern(_num, {
        [_zero]: _true,
        [_succ]: _false
    }))
];

const natTable = evalStmts(natNumbers, boolTable);
function makeNat(from: number): Value {
    const num = Math.abs(Math.floor(from)); // make it a nonnegative integer if it isn't already
    if(num == 0) return evalExpr(_0, natTable);
    else return evalExpr(new Construct(_Nat, _succ, {[_prev]: makeNat(num - 1).data}), natTable);
}
function parseNat(code: Expression, symTable: SymTable): number {
    const value = evalExpr(code, symTable).data as Obj;
    if(value.cons == _zero) return 0;
    else return 1 + parseNat(value.fields[_prev]!.data, symTable);
}
console.log(parseNat(makeNat(10).data, natTable).toString());

console.log(evalExpr(new Call(_is0, _anotherZero), natTable).toString());
console.log(evalExpr(new Call(_anotherIs0, _1), natTable).toString());
console.log(evalExpr(new Construct(_Nat, _succ, {[_prev]: new PropertyAccess(_2, _prev)}), natTable).toString());

// advanced object testing
const _Or = Symbol("Or"), _Or1 = Symbol("Or1"), _Or2 = Symbol("Or2"), _OrL = Symbol("OrL"), _OrR = Symbol("OrR"), _value = Symbol("value");
const orClass = new FuncDefinition(_Or, new Identifier(_Or1, Any), new Func(
    new Identifier(_Or2, Any),
    new ObjClass({
        [_OrL]: [new Identifier(_value, _Or1)],
        [_OrR]: [new Identifier(_value, _Or2)]
    }, "Or", [_Or1, _Or2])
));
const orTable = evalStmts([orClass], {});
console.log(evalExpr(
    new Construct(new Call(new Call(_Or, _Bool), _Nat), _OrL, {[_value]: _true}),
    {...natTable, ...orTable}
).toString());
const _And = Symbol("And"), _And1 = Symbol("And1"), _And2 = Symbol("And2"), _And_intro = Symbol("And_intro"), _fst = Symbol("fst"), _snd = Symbol("snd");
const andClass = new FuncDefinition(_And, new Identifier(_And1, Any), new Func(
    new Identifier(_And2, Any),
    new ObjClass({
        [_And_intro]: [new Identifier(_fst, _And1), new Identifier(_snd, _And2)],
    }, "And", [_And1, _And2])
));
const andTable = evalStmts([andClass], {});
console.log(evalExpr(
    new Construct(new Call(new Call(_And, _Bool), _Nat), _And_intro, {[_fst]: _true, [_snd]: _1}),
    {...natTable, ...andTable}
).toString());

// toaster testing
const _andAuto = Symbol("andAuto"), _a1 = Symbol("a1"), _a2 = Symbol("a2"), _orAutoL = Symbol("orAutoL"), _o1 = Symbol("o1"), _o2 = Symbol("o2");
console.log(evalExpr(
    new Return([
        new FuncDefinition(_orAutoL, new Identifier(_o1, Any), new Func(
            new Identifier(_o2, new UniverseType()),
            new Construct(new Call(new Call(_Or, new Toaster(_o1)), _o2), _OrL, {[_value]: _o1})
        ))
    ], new Call(new Call(_orAutoL, _0), _Bool)),
    {...natTable, ...orTable}
).toString());
console.log(evalExpr(
    new Return([
        new FuncDefinition(_andAuto, new Identifier(_a1, Any), new Func(
            new Identifier(_a2, Any),
            new Construct(new Call(new Call(_And, new Toaster(_a1)), new Toaster(_a2)), _And_intro, {[_fst]: _a1, [_snd]: _a2})
        ))
    ], new Call(new Call(_andAuto, _0), _false)),
    {...natTable, ...andTable}
).toString());
