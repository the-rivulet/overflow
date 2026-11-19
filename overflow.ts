// this just bugs me
Symbol.prototype.toString = function() { return this.description!; };

// anything that can be evaluated to get a value
type Expression = symbol | Thing | Call | Return | Match | Construct | PropertyAccess | Pattern;
// anything that can be evaluated to do something
type Statement = VarDefinition | FuncDefinition;
// anything that can be used as a type
// `symbol` appears again, because a symbol could point to a class
type Type = symbol | FuncType | ObjClass;

abstract class Thing { private readonly _thing!: void; }
// opaque values, used for passing in external arguments
class Opaque extends Thing {
    constructor(public data: any) { super(); }
    toString() {return `opaque "${this.data.toString()}"`;}
}
// a name with its type
class Identifier {
    constructor(public name: symbol, public kind: Type) {}
    toString() {return `${this.name.description} : ${this.kind.toString()}`;}
}
// a value with its type
class Value {
    constructor(public data: Thing, public kind: Type) {}
    toString() {return `${this.data} : ${this.kind.toString()}`;}
}

// calling a function on arguments
class Call {
    constructor(public func: Expression, public argument: Expression) {}
    toString(): string {return `${this.func.toString()}(${this.argument.toString()})`;}
}
// defining a variable, allowing its identifier to be meaningful when evaluated later
// this cannot be used to define functions, use `FuncDefinition` instead.
// this is not an expression, instead it is a statement.
class VarDefinition {
    constructor(public name: symbol, public value: Expression) {}
    toString() {return `${this.name.description} = ${this.value.toString()}`;}
}
// returns a value from a statement, allowing it to be used as an expression.
// this is the only way to have a statement return a value.
class Return {
    constructor(public stmts: Statement[], public returns: Expression) {}
    toString(): string {return `${this.stmts.map(x => x.toString()).join("; ")}; return ${this.returns.toString()}`;}
}
// used to define functions
class FuncDefinition {
    constructor(public name: symbol, public argument: Identifier, public definition: Expression) {}
    toString() {return `fn ${this.name.description}(${this.argument.toString()}) { ${this.definition.toString()} }`;}
}
// a function disconnected from its name. if a `FuncDefinition` is `const id = (x => x);`
// then the `Func` created would just be `x => x`
// when a `Func` is instantiated from a `FuncDefinition` or returned from another function, it captures its context
class Func extends Thing {
    closureTable: SymTable;
    constructor(public argument: Identifier, public definition: Expression) { super(); this.closureTable = {}; }
    toString(): string {return `(${this.argument.toString()}) => { ${this.definition.toString()} }`;}
}
class FuncType {
    constructor(public inType: Type, public outType: Type) {}
    toString(): string {return `(${this.inType.toString()} => ${this.outType.toString()})`;}
}
// match-expressions, the fundamental control flow pattern
class MatchCase {
    constructor(public lhs: Expression, public rhs: Expression) {}
    toString(): string {return `${this.lhs.toString()} -> ${this.rhs.toString()}`}
}
class Match {
    constructor(public variable: Expression, public cases: MatchCase[], public otherwise: Expression) {}
    toString(): string {return `match(${this.variable.toString()}) { ${[...this.cases, `else -> ${this.otherwise.toString()}`].map(x => x.toString()).join("; ")} }`;}
}

// objects are a very useful type, because they allow "more types" to be created.
// objects hold a collection of named and typed values
// `ObjClass` is like `Func` ... in that it is a `Thing`.
// the type of every `ObjClass` is a special type: `Symbol.for("Type")`
class ObjClass extends Thing {
    // each item in `constructors` is one way to construct this object
    constructor(public constructors: Record<symbol, Identifier[]>, private debugName: string = "") { super(); }
    toString() {return "class " + (this.debugName ? `'${this.debugName}'` : `{ ${Reflect.ownKeys(this.constructors).map(x => `${x.toString()} (${this.constructors[x as symbol]!.join(", ")})`).join(", ")} }`);}
}
// constructs a new object 
class Construct {
    constructor(public toaster: Expression, public cons: symbol, public fields: Record<symbol, Expression>) {}
    toString(): string {return `${this.toaster.toString()}.${this.cons.description}(${Reflect.ownKeys(this.fields).map(x => `${x.toString()} = ${this.fields[x as symbol]!.toString()}`).join(", ")})`}
}
// a constructed object
// there is no way to stop someone from constructing one of these with mismatched fields
// so in `evalExpr` we just have to make sure they're sound before they get actually used
class Obj extends Thing {
    constructor(public toaster: ObjClass, public cons: symbol, public fields: Record<symbol, Value>) { super(); }
    toString() {return `object ${this.cons.description} { ${Reflect.ownKeys(this.fields).map(x => `${x.toString()} (${this.fields[x as symbol]!})`).join(", ")} }`;}
}
// get a field of an object
class PropertyAccess {
    constructor(public obj: Expression, public field: symbol) {}
}
// objects have a special kind of matching that works on their constructors
// in Lean this is a normal match expression but I'm making it a different thing for convenience
class Pattern {
    constructor(public variable: Expression, public cases: Record<symbol, Expression>) {}
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
function isSameType(at: Type, bt: Type, symTable: SymTable): boolean {
    console.info(`Comparing types of ${at.toString()} and ${bt.toString()}`);
    // deref if needed
    // this may lead to infinite loops if comparing two classes with identically-named fields
    // where one is a class literal and the other is a symbol that dereferences to a class containing itself
    // that seems like a rare situation though so I will ignore it for now
    if(typeof at == "symbol" && typeof bt == "symbol") return at == bt;
    const a = (typeof at == "symbol") ? deref(at, symTable).data as Type : at;
    const b = (typeof bt == "symbol") ? deref(bt, symTable).data as Type : bt;
    // compare
    if(a instanceof FuncType) {
        return b instanceof FuncType && isSameType(a.inType, b.inType, symTable) && isSameType(a.outType, b.outType, symTable);
    } else if(a instanceof ObjClass) {
        return b instanceof ObjClass &&
        Reflect.ownKeys(a.constructors).length == Reflect.ownKeys(b.constructors).length &&
        Reflect.ownKeys(a.constructors).every(x => Reflect.ownKeys(b.constructors).includes(x)) &&
        Reflect.ownKeys(a.constructors).every(x => a.constructors[x as symbol]!.every(
            i => b.constructors[x as symbol]!.find(j => i.name == j.name && isSameType(i.kind, j.kind, symTable))
        ))
    }
    throw new Error("Did not match any path");
}
// function for checking whether values match
function isSameThing(a: Thing, b: Thing, symTable: SymTable): boolean {
    if(a instanceof Opaque) {
        // just use the default comparison function between these unknown values
        return b instanceof Opaque && a.data == b.data;
    } else if(a instanceof Func) {
        // functions cannot be "equal" per se
        return false;
    } else if(a instanceof ObjClass) {
        // classes are equal if their structures are the same
        return b instanceof ObjClass && isSameType(a, b, symTable);
    } else if(a instanceof Obj) {
        // objects are equal if all their fields are equal
        // and they were constructed from the same constructor
        // `isSameType` on the prototypes will check if they are structurally equal
        // so all we need to do here is ensure that the fields' data is equal
        return b instanceof Obj &&
        a.cons == b.cons &&
        isSameType(a.toaster, b.toaster, symTable) &&
        Reflect.ownKeys(a.fields).every(f => isSameThing(b.fields[f as symbol]!.data, b.fields[f as symbol]!.data, symTable));
    }
    throw new Error("Did not match any path");
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
    console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    if(code instanceof VarDefinition) {
        // add the variable with the appropriate type, but with a value of undefined
        // since it should never need to be evaluated for its value anyway
        return {...symTable, [code.name]: new Value(new Opaque(undefined), checkExprType(code.value, symTable))};
    } else if(code instanceof FuncDefinition) {
        // basically the same as `evalStmt`
        // again, return undefined as the value
        const symTable2 = {...symTable, [code.argument.name]: new Value(new Opaque(undefined), code.argument.kind)};
        return {...symTable, [code.name]: new Value(new Opaque(undefined), new FuncType(code.argument.kind, checkExprType(code.definition, symTable2)))};
    }
    throw new Error("Did not match any path");
}
// try to evaluate a statement, and return the new symbol table after evaluating
function evalStmt(code: Statement, symTable: SymTable): SymTable {
    console.info(`Executing '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    // do something based on what kind of statement it is
    if(code instanceof VarDefinition) {
        // define the variable and add it to the symbol table
        // throw an error if you try to reinstantiate an existing symbol
        // cause it's better for things to be const by default
        // especially important now that closures exist (because they would use the old value)
        if(code.name in symTable) {
            throw new Error(`${code.name.description} is already defined`);
        }
        return {...symTable, [code.name]: evalExpr(code.value, symTable)};
    } else if(code instanceof FuncDefinition) {
        // the whole thing will be stored in the symbol table so it can be called when needed
        // a variable just stores a value, but a function stores a whole object
        // when checking the function's return type, it may reference the argument
        // so the argument should be temporarily added to the symbol table while type-checking
        const symTable2 = {...symTable, [code.argument.name]: new Value(new Opaque(undefined), code.argument.kind)};
        const f = new Func(code.argument, code.definition);
        // the function captures the current symbol table
        console.info(`Adding a closure table: ${Reflect.ownKeys(symTable).map(x => x.toString()).join(", ")}`);
        f.closureTable = {...symTable};
        return {...symTable, [code.name]: new Value(f, new FuncType(code.argument.kind, checkExprType(code.definition, symTable2)))};
    }
    throw new Error("Did not match any path");
}
const evalStmts = (code: Statement[], symTable: SymTable) => code.reduce((table, stmt) => evalStmt(stmt, table), symTable);
// try to evaluate an expression, and return its type
function checkExprType(code: Expression, symTable: SymTable): Type {
    console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    if(typeof code == "symbol") {
        return deref(code, symTable).kind;
    } else if(code instanceof Thing) {
        // check which kind of object it is
        if(code instanceof Opaque) {
            return Symbol(); // functionally useless, since this is too opaque to say anything about
        } else if(code instanceof Func) {
            const symTable2 = {...symTable, [code.argument.name]: new Value(new Opaque(undefined), code.argument.kind)};
            return new FuncType(code.argument.kind, checkExprType(code.definition, symTable2));
        } else if(code instanceof ObjClass) {
            return Symbol.for("Type"); // the type of any class is type
        } else if(code instanceof Obj) {
            return code.toaster;
        }
        throw new Error(`Unknown Thing: ${code.toString()}`);
    } else if(code instanceof Call) {
        // first check the type of the thing we're calling...
        const vt = checkExprType(code.func, symTable);
        // ... and that it is a function
        if(!(vt instanceof FuncType)) {
            throw new Error(`${code.func.toString()} is not a function type, it is: ${vt.toString()}`);
        }
        // now check the type of the argument...
        const at = checkExprType(code.argument, symTable);
        // ... and ensure the argument's type is correct
        if(!(isSameType(at, vt.inType, symTable))) {
            throw new Error(`Cannot call function of type ${vt.toString()} with argument of type ${at.toString()}`);
        }
        // just give the return type
        return vt.outType;
    } else if(code instanceof Return) {
        // evaluate the statements in the `Return` for their types
        const symTable2 = code.stmts.reduce((table, stmt) => checkStmtType(stmt, table), {...symTable});
        return checkExprType(code.returns, symTable2);
    } else if(code instanceof Match) {
        if(code.cases.length == 0) throw new Error("Match has no arms");
        // the type should be the type of all match arms
        const arm1 = checkExprType(code.cases[0]!.rhs, symTable);
        for(const arm of code.cases.slice(1)) {
            const at = checkExprType(arm.rhs, symTable);
            if(!(isSameType(arm1, at, symTable))) throw new Error(`First match arm returns type ${arm1.toString()}, but another arm returns type ${at.toString()}`);
        }
        // check the default case too
        const defaultCase = checkExprType(code.otherwise, symTable);
        if(!(isSameType(arm1, defaultCase, symTable))) throw new Error(`First match arm returns type ${arm1.toString()}, but default case returns type ${defaultCase.toString()}`);
        return arm1;
    } else if(code instanceof Construct) {
        // yeah idk how to do this other than just evaluating it
        return evalExpr(code.toaster, symTable).kind;
    } else if(code instanceof PropertyAccess) {
        // see above.
        return evalExpr(code, symTable).kind;
    } else if(code instanceof Pattern) {
        const keys = Reflect.ownKeys(code.cases) as symbol[];
        if(keys.length == 0) throw new Error("Pattern has no cases");
        // the type should be the type of all match arms
        const arm1 = checkExprType(code.cases[keys[0]!]!, symTable);
        for(const arm of keys.slice(1)) {
            const at = checkExprType(code.cases[arm]!, symTable);
            if(!(isSameType(arm1, at, symTable))) throw new Error(`First pattern returns type ${arm1.toString()}, but another arm returns type ${at.toString()}`);
        }
        return arm1;
    }
    throw new Error("Did not match any path");
}
// try to evaluate an expression, and return its value
function evalExpr(code: Expression, symTable: SymTable): Value {
    console.info(`Evaluating '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => x.toString()).join(", ")}`);
    // do something based on what kind of expression it is
    if(typeof code == "symbol") {
        return deref(code, symTable);
    } else if(code instanceof Thing) {
        if(code instanceof Func) {
            // if the value is a function, it captures its context in this moment
            console.info(`Adding a closure table: ${Reflect.ownKeys(symTable).map(x => x.toString()).join(", ")}`);
            code.closureTable = {...symTable};
        } else if(code instanceof Obj) {
            // if the value is an object, this is a good time to check it and make sure
            // that its properties match what is expected
            // first check the constructor
            if(!(code.cons in code.toaster.constructors)) {
                throw new Error(`${code.cons.description} is not a constructor for ${code.toaster.toString()}`);
            }
            // then check the properties
            // it should have all of the properties it claims to have
            // and should not have any properties it does not need
            const setP = code.toaster.constructors[code.cons]!;
            const setO = Reflect.ownKeys(code.fields);
            if(setP.length != setO.length) {
                throw new Error(`Wrong number of fields (provided ${setO.length}, wanted ${setP.length})`);
            }
            const missing = setP.find(key => !(setO.includes(key.name)));
            if(missing) {
                throw new Error(`Object is missing a property: ${missing.name.description}`);
            }
            // finally, make sure that the types of all properties are correct
            const wrong = setP.find(key => !(isSameType(code.fields[key.name]!.kind, key.kind, symTable)));
            if(wrong) {
                throw new Error(`Field is the wrong type (provided ${code.fields[wrong.name]?.toString()}, wanted ${wrong.kind.toString()})`);
            }
        }
        // return the value along with its type
        return new Value(code, checkExprType(code, symTable));
    } else if(code instanceof Call) {
        // first make sure that the thing we're calling is defined...
        const v = evalExpr(code.func, symTable);
        // ... and that it is a function
        if(!(v.data instanceof Func)) {
            throw new Error(`${code.func.toString()} is not a function, it is: ${v.toString()}`);
        }
        const f: Func = v.data;
        // now evaluate the argument...
        const a = evalExpr(code.argument, symTable);
        // ... and ensure the argument's type is correct
        if(!(isSameType(a.kind, f.argument.kind, symTable))) {
            throw new Error(`Expected an argument of type ${f.argument.kind.toString()}, but got ${a.kind.toString()}`);
        }
        // make a copy of the symbol table to add the argument to it
        // a copy is made because the argument symbols should not be retained after the function call
        // also add the closure table if the function has one
        const innerSymTable: SymTable = {...symTable, ...f.closureTable, [f.argument.name]: a};
        // after filling out the arguments in `innerSymTable`, evaluate it
        return evalExpr(f.definition, innerSymTable);
    } else if(code instanceof Return) {
        // this means statements will get involved.
        const outTable = code.stmts.reduce((table, stmt) => evalStmt(stmt, table), symTable);
        return evalExpr(code.returns, outTable);
    } else if(code instanceof Match) {
        const v = evalExpr(code.variable, symTable);
        // call the appropriate expression
        for(const c of code.cases) {
            const lhs = evalExpr(c.lhs, symTable);
            if(isSameValue(v, lhs, symTable)) return evalExpr(c.rhs, symTable);
        }
        return evalExpr(code.otherwise, symTable);
    } else if(code instanceof Construct) {
        // construct an object
        // the actual fields of the object will be checked in the `Thing` branch of this function
        // so no need to do the work twice
        const cons = evalExpr(code.toaster, symTable);
        if(!(cons.data instanceof ObjClass)) {
            throw new Error(`${code.toaster.toString()} is not a class, it is: ${cons.toString()}`);
        }
        // evaluate each field
        const computedFields: Record<symbol, Value> = {};
        for(const key of Reflect.ownKeys(code.fields)) {
            computedFields[key as symbol] = evalExpr(code.fields[key as symbol]!, symTable);
        }
        return evalExpr(new Obj(cons.data, code.cons, computedFields), symTable);
    } else if(code instanceof PropertyAccess) {
        // once again, ensure that the expression is the proper type...
        const obj = evalExpr(code.obj, symTable);
        if(!(obj.data instanceof Obj)) {
            throw new Error(`${code.obj.toString()} is not an object, it is: ${obj.toString()}`);
        }
        // ... then attempt to get its field
        if(!(code.field in obj.data.fields)) {
            throw new Error(`That object does not have a field named ${code.field.description}`);
        }
        return obj.data.fields[code.field]!;
    } else if(code instanceof Pattern) {
        // this is a familiar pattern by now
        const obj = evalExpr(code.variable, symTable);
        if(!(obj.data instanceof Obj)) {
            throw new Error(`${code.variable.toString()} is not an object, it is: ${obj.toString()}`);
        }
        // first, ensure all cases are handled
        const setP = Reflect.ownKeys(obj.data.toaster.constructors) as symbol[];
        const setO = Reflect.ownKeys(code.cases);
        if(setP.length != setO.length) {
            throw new Error(`Wrong number of cases in pattern (provided ${setO.length}, wanted ${setP.length})`);
        }
        const missing = setP.find(key => !(setO.includes(key)));
        if(missing) {
            throw new Error(`Pattern is missing a case: ${missing.description}`);
        }
        return evalExpr(code.cases[obj.data.cons]!, symTable);
    }
    throw new Error("Did not match any path");
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
