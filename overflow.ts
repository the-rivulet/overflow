// this just bugs me
Symbol.prototype.toString = function() { return this.description!; };

// anything that can be evaluated to get a value
type Expression = symbol | Call | Return | Match;
// anything that can be evaluated to do something
type Statement = VarDefinition | FuncDefinition;
// anything that can be a variable's value
type Object = Opaque | Func;
// anything that can be used as a type 
type Type = symbol | FuncType;

// opaque values, used for passing in external arguments
class Opaque {
    constructor(public data: any) {}
    toString() {return `opaque "${this.data.toString()}"`;}
}
// a name with its type
class Identifier<Name extends symbol = symbol, Kind extends Type = Type> {
    constructor(public name: Name, public kind: Kind) {}
    toString() {return `${this.name.description} : ${this.kind.toString()}`;}
}
// a value with its type
class Value<Data extends Object = Object, Kind extends Type = Type> {
    constructor(public data: Data, public kind: Kind) {}
    toString() {return `${this.data} : ${this.kind.toString()}`;}
}

// calling a function on arguments
class Call<Func extends Expression = Expression, Argument extends Expression = Expression> {
    constructor(public func: Func, public argument: Argument) {}
    toString(): string {return `${this.func.toString()}(${this.argument.toString()})`;}
}
// defining a variable, allowing its identifier to be meaningful when evaluated later
// this cannot be used to define functions, use `FuncDefinition` instead.
// this is not an expression, instead it is a statement.
class VarDefinition<Name extends symbol = symbol, Value extends Expression = Expression> {
    constructor(public name: Name, public value: Value) {}
    toString() {return `${this.name.description} = ${this.value.toString()}`;}
}
// returns a value from a statement, allowing it to be used as an expression.
// this is the only way to have a statement return a value.
class Return<Code extends Statement[] = Statement[], Returns extends Expression = Expression> {
    constructor(public stmts: [...Code], public returns: Returns) {}
    toString(): string {return `${this.stmts.map(x => x.toString()).join("; ")}; return ${this.returns.toString()}`;}
}
// used to define functions
class FuncDefinition<Name extends symbol = symbol, Argument extends Identifier = Identifier, Definition extends Expression = Expression> {
    constructor(public name: Name, public argument: Argument, public definition: Definition) {}
    toString() {return `fn ${this.name.description}(${this.argument.toString()}) { ${this.definition.toString()} }`;}
}
class Func<Argument extends Identifier = Identifier, Definition extends Expression = Expression> {
    constructor(public argument: Argument, public definition: Definition) {}
    toString() {return `(${this.argument.toString()}) => { ${this.definition.toString()} }`;}
}
class FuncType<InType extends Type = Type, OutType extends Type = Type> {
    constructor(public inType: InType, public outType: OutType) {}
    toString(): string {return `(${this.inType.toString()} => ${this.outType.toString()})`;}
}
// match-expressions, the fundamental control flow pattern
class MatchCase<Left extends Expression = Expression, Right extends Expression = Expression> {
    constructor(public lhs: Left, public rhs: Right) {}
    toString(): string {return `${this.lhs.toString()} -> ${this.rhs.toString()}`}
}
class Match<Variable extends Expression = Expression, Cases extends MatchCase[] = MatchCase[], Default extends Expression = Expression> {
    constructor(public variable: Variable, public cases: [...Cases], public otherwise: Default) {}
    toString(): string {return `match(${this.variable.toString()}) { ${[...this.cases, `else -> ${this.otherwise.toString()}`].map(x => x.toString()).join("; ")} }`;}
}

// utility function for checking whether types match
function isSameType(a: Type, b: Type): boolean {
    if(typeof a == "symbol") {
        return a == b; // symbols must be exactly the same
    } else if(a instanceof FuncType) {
        return b instanceof FuncType && isSameType(a.inType, b.inType) && isSameType(a.outType, b.outType);
    }
    throw new Error("Did not match any path");
}

// the symbol table holds the value of every variable
type SymTable = Record<symbol, Value>;

// try to evaluate a statement, but only for its type
function checkStmtType(code: Statement, symTable: SymTable): SymTable {
    console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    if(code instanceof VarDefinition) {
        return {...symTable, [code.name]: new Value(new Opaque(undefined), checkExprType(code.value, symTable))};
    } else if(code instanceof FuncDefinition) {
        // literally the same as `evalStmt`
        // since we have all the information anyway
        const symTable2 = {...symTable, [code.argument.name]: new Value(new Opaque(undefined), code.argument.kind)};
        return {...symTable, [code.name]: new Value(code, new FuncType(code.argument.kind, checkExprType(code.definition, symTable2)))};
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
        return {...symTable, [code.name]: new Value(code, new FuncType(code.argument.kind, checkExprType(code.definition, symTable2)))};
    }
    throw new Error("Did not match any path");
}
const evalStmts = (code: Statement[], symTable: SymTable) => code.reduce((table, stmt) => evalStmt(stmt, table), symTable);
// try to evaluate an expression, and return its type
function checkExprType(code: Expression, symTable: SymTable): Type {
    console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    if(typeof code == "symbol") {
        // if an identifier, attempt to resolve it using the symbol table
        // raise an error if not defined
        if(!(code in symTable)) {
            throw new Error(`Couldn't resolve identifier: ${code.toString()}`);
        }
        // otherwise return whatever it was
        return symTable[code]!.kind;
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
        if(!(isSameType(at, vt))) {
            throw new Error(`Cannot call function of type ${vt.toString()} with argument of type ${at.toString()}`);
        }
        // just give the return type
        return vt.outType;
    } else if(code instanceof Return) {
        // evaluate the statements in the `Return` for their types
        let symTable2 = code.stmts.reduce((table, stmt) => checkStmtType(stmt, table), {...symTable});
        return checkExprType(code.returns, symTable2);
    } else if(code instanceof Match) {
        if(code.cases.length == 0) throw new Error("Match has no arms");
        // the type should be the type of all match arms
        const arm1 = checkExprType(code.cases[0]!.rhs, symTable);
        for(const arm of code.cases.slice(1)) {
            const at = checkExprType(arm.rhs, symTable);
            if(!(isSameType(arm1, at))) throw new Error(`First match arm returns type ${arm1.toString()}, but another arm returns type ${at.toString()}`);
        }
        return arm1;
    }
    throw new Error("Did not match any path");
}
// try to evaluate an expression, and return its value
function evalExpr(code: Expression, symTable: SymTable): Value {
    console.info(`Evaluating '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    // do something based on what kind of expression it is
    if(typeof code == "symbol") {
        // if an identifier, attempt to resolve it using the symbol table
        // raise an error if not defined
        if(!(code in symTable)) {
            throw new Error(`Couldn't resolve identifier: ${code.toString()}`);
        }
        // otherwise return whatever it was
        return symTable[code]!;
    } else if(code instanceof Call) {
        // first make sure that the thing we're calling is defined...
        const v = evalExpr(code.func, symTable);
        // ... and that it is a function
        if(!(v.data instanceof FuncDefinition)) {
            throw new Error(`${code.func.toString()} is not a function, it is: ${v}`);
        }
        const f: FuncDefinition<symbol, Identifier, Expression> = v.data;
        // now evaluate the argument...
        const a = evalExpr(code.argument, symTable);
        // ... and ensure the argument's type is correct
        if(!(isSameType(a.kind, f.argument.kind))) {
            throw new Error(`${f.name.description} expected an argument of type ${f.argument.kind.toString()}, but got ${a.kind.toString()}`);
        }
        // make a copy of the symbol table to add the argument to it
        // a copy is made because the argument symbols should not be retained after the function call
        const innerSymTable: SymTable = {...symTable};
        innerSymTable[f.argument.name] = a;
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
            if(v == lhs) return evalExpr(c.rhs, symTable);
        }
        return evalExpr(code.otherwise, symTable);
    }
    throw new Error("Did not match any path");
}

// boolean operations
const _bool = Symbol("bool"), _true = Symbol("true"), _false = Symbol("false");
const _x = Symbol("x"), _y = Symbol("y");
const _not = Symbol("not");
const booleanOps = evalStmts([
    new FuncDefinition(_not, new Identifier(_x, _bool), new Match(
        _x, [new MatchCase(_true, _false)], _true
    ))
], {[_true]: new Value(new Opaque(true), _bool), [_false]: new Value(new Opaque(false), _bool)});